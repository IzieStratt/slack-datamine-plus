// SPDX-License-Identifier: AGPL-3.0-only
// Extractors ported from 3kh0/slack-datamine (GPL-3.0, see src/upstream/LICENSE.GPL-3.0 and NOTICE.md): the rspack-era
// extractors in src/upstream/*.js (CommonJS, unchanged), plus the i18n and UI-string passes that lived in its datamine.js.
// Same contract as their miner: each extractor runs per chunk through run(js, add), then post(values) once over the union.
// Keys whose extraction threw, or whose translation table was missing, keep the previous file instead of emptying it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CJS = [...require('./upstream/flags.js'), ...require('./upstream/api.js'), ...require('./upstream/catalogs.js')];

// Files that clash with the names this miner already writes. api-methods and experiments are different lists under the same name,
// so the upstream copies get their own file; the rest share a file and are unioned by the caller.
const RENAME = { 'api-methods.txt': 'api-methods-upstream.txt', 'experiments.txt': 'experiments-upstream.txt' };

const I18N = new Map(); // 7-char sha1 of a string -> namespaces whose en-US table contains it
const sortUniq = (a) => [...new Set(a)].sort();
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 7);
const cmp = (a, b) => (a > b) - (a < b);
const unesc = (r) => r.replace(/\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|(\r\n|[\s\S]))/g, (_, x, U, u, c) =>
  x || u ? String.fromCharCode(parseInt(x || u, 16)) : U ? String.fromCodePoint(parseInt(U, 16))
    : ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' })[c] ?? (c === '\n' || c === '\r\n' ? '' : c));
const oneLine = (s) => s.replace(/[\\\n\r\t]/g, (c) => ({ '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' })[c]);
function* lits(js, tOnly) {
  if (I18N.size) for (const m of js.matchAll(/(\.t\()?(?:"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'|`((?:\\.|[^`\\$])*)`)/g)) {
    const r = m[2] ?? m[3] ?? m[4];
    if (r && (!tOnly || m[1])) yield [unesc(r), m[1]];
  }
}
const RE_STR = /['"]([^'"\\\n]{8,200})['"]/g;

const DATAMINE = [
  { key: 'i18nStrings', file: 'strings-en-US.txt', run: (js, add) => {
    for (const [s, t] of lits(js)) { const k = hash(s); if (I18N.has(k) && (t || /[\s{A-Z]/.test(s))) add(`${k}\t${s}`); }
  }, post: (vals) => vals.flatMap((v) => (I18N.get(v.slice(0, 7)) || []).map((ns) => [ns, v.slice(8), `${ns}.${v.slice(0, 7)}: ${oneLine(v.slice(8))}`]))
    .sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1])).map((x) => x[2]) },
  { key: 'i18nUntranslated', file: 'strings-untranslated.txt', run: (js, add) => {
    for (const [s] of lits(js, true)) if (!I18N.has(hash(s))) add(oneLine(s));
  } },
  { key: 'uiStrings', file: 'ui-strings.txt', run: (js, add) => {
    for (const m of js.matchAll(RE_STR)) {
      const s = m[1];
      if (s.split(/\s+/).length < 2) continue; // 2+ words min
      if (/[{}<>=`]|:\/\/|=>|\b(?:function|var|return)\b/.test(s)) continue; // not code
      if (/[/\\]|__|--/.test(s)) continue; // no paths or classes
      if (!/[a-z]/.test(s)) continue;
      if (!/^[A-Z“"']/.test(s) && !/[.!?]$/.test(s)) continue; // sentence-ish
      add(s);
    }
  } },
];

export const EXTRACTORS = [...CJS, ...DATAMINE].map((e) => ({ ...e, file: RENAME[e.file] ?? e.file }));

// The en-US translation table is named on the client page: "en-US":"gantry-v2-translations_<ns>....json". Each table maps
// namespace -> { key: english }. Returns false when no table was found (the i18n files then keep their previous contents).
export async function loadTranslations(htmls, cdn, get) {
  const names = [...new Set(htmls.flatMap((h) => [...h.matchAll(/"([a-z]{2}-[A-Z]{2})":"(gantry-v2-translations_[^"?]+\.json)/g)]
    .filter((m) => m[1] === 'en-US').map((m) => m[2])))];
  if (!names.length) return false;
  I18N.clear();
  for (const name of names) {
    const r = await get(cdn + name);
    if (r.status !== 200) throw new Error(`translation table ${name}: HTTP ${r.status}`);
    for (const [ns, o] of Object.entries(JSON.parse(r.js))) for (const k in o) (I18N.get(k) || I18N.set(k, []).get(k)).push(ns);
  }
  return true;
}

// One run: collect() per fetched chunk, then finish(readPrev) once. readPrev(file) returns the previous lines of an output file.
export function createUpstream({ hasTranslations = () => I18N.size > 0 } = {}) {
  const sets = new Map(EXTRACTORS.map((e) => [e.key, new Set()]));
  const errors = new Map();
  const note = (e, phase, err) => errors.has(e.key) || errors.set(e.key, `${phase}: ${err?.message || err}`);
  return {
    collect(js) {
      for (const e of EXTRACTORS) {
        try { e.run(js, (x) => sets.get(e.key).add(x)); } catch (err) { note(e, 'run', err); }
      }
    },
    finish(readPrev) {
      const out = new Map(), notes = [];
      const i18nOk = hasTranslations();
      for (const e of EXTRACTORS) {
        const prev = () => readPrev(e.file);
        if (/^i18n/.test(e.key) && !i18nOk) { out.set(e.file, prev()); notes.push(`${e.key}: no en-US table, kept old`); continue; }
        let v = sortUniq([...sets.get(e.key)]);
        if (e.post) try { v = e.post(v); } catch (err) { note(e, 'post', err); v = null; }
        if (errors.has(e.key)) { out.set(e.file, prev()); notes.push(`${e.key} broke (${errors.get(e.key)}), kept old`); continue; }
        out.set(e.file, v.filter((x) => typeof x === 'string' && !/^[~\0]/.test(x)));
      }
      return { files: out, notes };
    },
  };
}

// Output lines of a previous run, so a broken extractor keeps what it had.
export const readLines = (dir) => (file) => {
  const p = path.join(dir, file);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
};
