#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// What does Taut (https://github.com/jeremy46231/taut) look up in Slack's client?  node src/taut-usage.mjs <taut checkout> [--json]
// Plugins and the app reach into the client by name, through a handful of api calls, each taking the name as a string literal:
//   patchComponent('Name', ...)                      a React component (build/components.json)
//   redux.patchThunk / waitForThunkCreator / dispatchThunk('name', ...)   a thunk (build/redux.json)
//   byMeta('name')                                   something registered with .meta (any redux kind)
//   byName('name')                                   an export found by its function name (not in the inventories; can't be checked)
//   rtm.on('type', ...)                              a websocket event type
//   experiments.set / get('name', ...)               an experiment (build/experiments.json)
// Names built at runtime (a variable, a template) can't be read statically; those calls are counted as `dynamic`.
import fs from 'node:fs';
import path from 'node:path';

const CALLS = [
  ['component', /\bpatchComponent\s*(?:<[^()]*>)?\s*\(\s*(['"`])([^'"`]+)\1/g],
  ['thunk', /\b(?:patchThunk|waitForThunkCreator|dispatchThunk)\s*(?:<[^()]*>)?\s*\(\s*(['"`])([^'"`]+)\1/g],
  ['byMeta', /\bbyMeta\s*(?:<[^()]*>)?\s*\(\s*(['"`])([^'"`]+)\1/g],
  ['byName', /\bbyName\s*(?:<[^()]*>)?\s*\(\s*(['"`])([^'"`]+)\1/g],
  ['rtm', /\brtm\s*\.\s*on\s*(?:<[^()]*>)?\s*\(\s*(['"`])([^'"`]+)\1/g],
  ['experiment', /\bexperiments\s*\.\s*(?:set|get)\s*(?:<[^()]*>)?\s*\(\s*(['"`])([^'"`]+)\1/g],
];
const DYNAMIC = /\b(?:patchComponent|patchThunk|waitForThunkCreator|dispatchThunk|byMeta|byName)\s*(?:<[^()]*>)?\s*\(\s*(?!['"`])[^)\s]/g;

function* sources(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) yield p;
  }
}

// returns {uses: [{kind, name, file, line}], dynamic: number}
export function scanTaut(root) {
  const uses = [];
  let dynamic = 0;
  for (const dir of ['plugins', 'app', 'shared']) {
    if (!fs.existsSync(path.join(root, dir))) continue;
    for (const file of sources(path.join(root, dir))) {
      const text = fs.readFileSync(file, 'utf8');
      const lineOf = (i) => text.slice(0, i).split('\n').length;
      for (const [kind, re] of CALLS) for (const m of text.matchAll(re)) uses.push({ kind, name: m[2], file: path.relative(root, file), line: lineOf(m.index) });
      dynamic += [...text.matchAll(DYNAMIC)].length;
    }
  }
  uses.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
  return { uses, dynamic };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2];
  if (!root) { console.error('usage: taut-usage.mjs <taut checkout> [--json]'); process.exit(1); }
  const r = scanTaut(root);
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 1));
  else { for (const u of r.uses) console.log(`${u.kind}\t${u.name}\t${u.file}:${u.line}`); console.error(`${r.uses.length} uses, ${r.dynamic} dynamic`); }
}
