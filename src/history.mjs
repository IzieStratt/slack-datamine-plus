#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Per-item history: when each value of each category list was first seen, and when it went away. Written to build/history.tsv,
// one row per (category, value), sorted, so git diffs stay small and a run that changes nothing writes the same bytes.
//
//   node src/history.mjs              incremental: fold the lists as they are on disk now into build/history.tsv, dated today (UTC)
//   node src/history.mjs --rebuild    replay the first-parent git history of build/ from scratch (read-only; needs the full history)
//   [--date YYYY-MM-DD] [--out <file>]
//
// Columns: category, value, first_seen, last_seen, removed. last_seen and removed are empty while the value is still listed (the
// last commit of the list is its last-seen date then; writing it would change every row on every run). A value that comes back
// after being removed keeps its first_seen and loses last_seen/removed again.
// Categories: build/<name>.txt and build/platforms/<target>/<name>.txt ("<target>/<name>"), minus the ones in SKIP.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

// hashed or huge lists: content hashes change every build, the string tables and release notes are ~100k rows of prose (and minified
// code), and api-args / api-errors rows are whole "method: a, b, c" lists that would pile up a removed row per change
export const SKIP = new Set(['chunks', 'chunk-names', 'ui-strings', 'strings-en-US', 'strings-untranslated', 'sources', 'api-args', 'api-errors', 'android/strings-en', 'desktop/strings-en', 'desktop/bundle-files']);
const SKIP_TARGETS = new Set(['release-notes']);
export const HEADER = '# category\tvalue\tfirst_seen\tlast_seen\tremoved';

// "build/api-methods.txt" -> "api-methods", "build/platforms/android/feature-flags.txt" -> "android/feature-flags", else null
export function categoryOf(file) {
  const m = file.match(/^build\/(?:platforms\/([\w-]+)\/)?([\w-]+)\.txt$/);
  if (!m || (m[1] && (m[2] === 'info' || SKIP_TARGETS.has(m[1])))) return null;
  const c = m[1] ? `${m[1]}/${m[2]}` : m[2];
  return SKIP.has(c) ? null : c;
}

const escCell = (s) => s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t');
const unescCell = (s) => s.replace(/\\(.)/g, (_, c) => (c === 't' ? '\t' : c));
export const valuesOf = (text) => new Set((text ?? '').split('\n').filter(Boolean));

// index: Map<category, Map<value, {first, last, removed}>>
export function parseIndex(text) {
  const index = new Map();
  for (const line of (text ?? '').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [c, v, first, last, removed] = line.split('\t');
    if (!index.has(c)) index.set(c, new Map());
    index.get(c).set(unescCell(v), { first, last: last || null, removed: removed || null });
  }
  return index;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // byte order, so the output does not depend on the locale
export function serializeIndex(index) {
  const rows = [HEADER];
  for (const c of [...index.keys()].sort(cmp)) {
    for (const v of [...index.get(c).keys()].sort(cmp)) {
      const e = index.get(c).get(v);
      rows.push([c, escCell(v), e.first, e.last ?? '', e.removed ?? ''].join('\t'));
    }
  }
  return rows.join('\n') + '\n';
}

// Fold one snapshot of a category into the index. `values` null = the list no longer exists (everything in it is gone).
// `lastDate` is the date the previous snapshot was taken (the last day the removed values were still listed).
export function applySnapshot(index, cat, values, date, lastDate = date) {
  const m = index.get(cat) ?? index.set(cat, new Map()).get(cat);
  const now = values ?? new Set();
  for (const v of now) {
    const e = m.get(v);
    if (!e) m.set(v, { first: date, last: null, removed: null });
    else if (e.removed) { e.removed = null; e.last = null; }
  }
  for (const [v, e] of m) if (!e.removed && !now.has(v)) { e.removed = date; e.last = lastDate; }
  if (!m.size) index.delete(cat);
  return index;
}

const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'], ...opts });

// Replays every first-parent commit that touched build/, oldest first. Commit dates are UTC days.
export function rebuild(cwd = '.') {
  const log = git(['log', '--first-parent', '--reverse', '--format=@%H %cd', '--date=format-local:%Y-%m-%d', '--name-only', '--', 'build/'], { cwd, env: { ...process.env, TZ: 'UTC' } });
  const commits = [];
  for (const line of log.split('\n')) {
    if (line.startsWith('@')) { const [h, d] = line.slice(1).split(' '); commits.push({ h, d, files: [] }); }
    else if (line && categoryOf(line)) commits.at(-1).files.push(line);
  }
  // one `git cat-file --batch` per commit, so thousands of file reads cost a handful of processes
  // last_seen of a removed value = the date of the commit before the one that dropped it (any build/ commit: the value was listed there)
  const index = new Map();
  let prev = null;
  for (const { h, d, files } of commits) {
    const lastDate = prev ?? d;
    prev = d;
    if (!files.length) continue;
    const out = spawnSync('git', ['cat-file', '--batch'], { cwd, input: files.map((f) => `${h}:${f}`).join('\n') + '\n', maxBuffer: 1 << 30 }).stdout;
    let at = 0;
    for (const f of files) {
      const nl = out.indexOf(10, at);
      const head = out.subarray(at, nl).toString();
      at = nl + 1;
      let text = null;
      if (!head.endsWith(' missing')) {
        const size = Number(head.split(' ')[2]);
        text = out.subarray(at, at + size).toString('utf8');
        at += size + 1;
      }
      applySnapshot(index, categoryOf(f), text === null ? null : valuesOf(text), d, lastDate);
    }
  }
  return index;
}

// The lists on disk now, against the index. Lists that disappeared from disk count as emptied. `lastDate`: when the lists as committed
// (HEAD) were mined, i.e. the last day a value removed now was still listed.
export function update(index, date, cwd = '.', lastDate = date) {
  const onDisk = new Set();
  const walk = (dir) => { if (fs.existsSync(path.join(cwd, dir))) for (const d of fs.readdirSync(path.join(cwd, dir), { withFileTypes: true })) {
    const f = `${dir}/${d.name}`;
    if (d.isDirectory()) { if (dir === 'build' && d.name === 'platforms') walk(f); else if (dir === 'build/platforms') walk(f); }
    else if (categoryOf(f)) onDisk.add(f);
  } };
  walk('build');
  const byCat = new Map([...onDisk].map((f) => [categoryOf(f), f]));
  for (const cat of new Set([...index.keys(), ...byCat.keys()])) {
    const f = byCat.get(cat);
    const before = new Set([...(index.get(cat)?.entries() ?? [])].filter(([, e]) => !e.removed).map(([v]) => v));
    const now = f ? valuesOf(fs.readFileSync(path.join(cwd, f), 'utf8')) : null;
    const same = now && now.size === before.size && [...now].every((v) => before.has(v));
    if (!same) applySnapshot(index, cat, now, date, lastDate);
  }
  return index;
}

// HEAD's commit date (UTC). Works in a shallow (depth 1) checkout, which is what the mine workflow has.
function headDate() {
  try { return git(['log', '-1', '--format=%cd', '--date=format-local:%Y-%m-%d'], { env: { ...process.env, TZ: 'UTC' } }).trim() || null; } catch { return null; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
  const out = arg('--out', 'build/history.tsv');
  const date = arg('--date', new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error(`bad --date ${date}`); process.exit(1); }
  const before = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
  let index;
  if (process.argv.includes('--rebuild')) index = rebuild();
  else if (before === null) { console.error(`${out} missing: run with --rebuild first (needs the full git history)`); process.exit(1); }
  else index = update(parseIndex(before), date, '.', headDate() ?? date);
  const text = serializeIndex(index);
  if (text === before) console.log('history: unchanged');
  else {
    fs.writeFileSync(out, text);
    const rows = [...index.values()].reduce((n, m) => n + m.size, 0);
    console.log(`history: ${rows} values in ${index.size} categories -> ${out}`);
  }
}
