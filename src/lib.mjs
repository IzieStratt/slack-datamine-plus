// SPDX-License-Identifier: AGPL-3.0-only
// Pure helpers: chunk discovery, decoding, extraction, state merge. No network here, so tests can cover them.
import zlib from 'node:zlib';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const KNOWN_NS = new Set(
  fs.readFileSync(fileURLToPath(new URL('./namespaces.txt', import.meta.url)), 'utf8').split('\n').filter(Boolean),
);

// Slack serves chunks brotli-compressed (the "-br" in the CDN path). Fall back to gzip, then raw.
export function decode(buf) {
  for (const f of [zlib.brotliDecompressSync, zlib.gunzipSync]) {
    try { return f(buf).toString('utf8'); } catch {}
  }
  return buf.toString('utf8');
}

export const validBuild = (b) => typeof b === 'string' && /^(?:[0-9]{5,8}|[0-9a-f]{12})$/.test(b);

export function buildInfo(html) {
  const attr = (n) => html.match(new RegExp(`${n}["']?\\s*[:=]\\s*["']([^"']+)["']`))?.[1] ?? null;
  const cdn = html.match(/https:\/\/a\.slack-edge\.com\/bv[0-9-]+br\//)?.[0] ?? null;
  const info = {
    buildNumber: attr('build-number') || attr('build_number') || html.match(/boot_data\.version_uid\s*=\s*"([0-9a-f]{12})/)?.[1] || html.match(/"version_ts":(\d+)/)?.[1] || null,
    versionTs: html.match(/"version_ts":\s*"?(\d+)/)?.[1] ?? null,
    versionHash: html.match(/version_uid"?\s*[:=]\s*"([0-9a-f]{40})"/)?.[1] ?? null,
    cdn,
  };
  if (!validBuild(info.buildNumber)) info.buildNumber = null; // never trust page text as a shell/commit argument
  return info;
}

const FILE_RE = /([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.[0-9a-f]{16,}\.min\.js)/g;
const ASYNC_RE = /if\("([^"]+)"===e\)return"gantry-v2-async-"\+e\+"\.([0-9a-f]{8,})\.min\.js/g;

// Chunk filenames mentioned in a piece of text (the HTML, or any already-fetched script).
export function chunkFiles(text) {
  const files = new Set();
  for (const m of text.matchAll(ASYNC_RE)) files.add(`gantry-v2-async-${m[1]}.${m[2]}.min.js`);
  for (const m of text.matchAll(FILE_RE)) files.add(m[1]);
  return files;
}

// The gantry client page carries its async chunk list inline, as `p.u=e=>{var __cf={"name":"hash",...};...return "gantry-v2-async-"+e+"."+__cf[e]+".min.js"`.
export function chunkMapFiles(text) {
  const files = new Set();
  for (const m of text.matchAll(/\b__cf\s*=\s*\{([^{}]*)\}/g)) for (const p of m[1].matchAll(/(?:"([^"]+)"|([A-Za-z0-9_$]+))\s*:\s*"([0-9a-f]{8,})"/g)) files.add(`gantry-v2-async-${p[1] ?? p[2]}.${p[3]}.min.js`);
  return files;
}

// Since ~2026-07 the chunk list lives in the public webpack.manifest script as an rspack/webpack `.u` name->hash map:
//   __webpack_require__.u=e=>""+e+"."+({"about-usergroup-view":"cf49...",plain_key:"8da0..."})[e]+".min.js"
// Keys are quoted only when they are not valid identifiers, so JSON.parse can't be used.
export function manifestUrl(html) {
  return html.match(/https:\/\/a\.slack-edge\.com\/[^"'\s]*webpack\.manifest\.[0-9a-f]+\.min\.js/)?.[0] ?? null;
}

export function manifestChunks(js) {
  const map = js.match(/\.u=e=>""\+e\+"\."\+\((\{.*?\})\)\[e\]\+"\.min\.js"/)?.[1];
  if (!map) return new Set();
  const files = new Set();
  for (const m of map.matchAll(/(?:"([^"]+)"|([A-Za-z0-9_$]+)):"([0-9a-f]{8,})"/g)) files.add(`${m[1] ?? m[2]}.${m[3]}.min.js`);
  return files;
}

// Syntax-highlighting grammars (TextMate scope names like entity.name.function.apl) look like API names. Skip those chunks.
export const isGrammarChunk = (file) => /node_modules_(shikijs?|mermaid|codemirror|highlight|prismjs|monaco|vscode-textmate|lezer)|^codemirror|^(shiki|mermaid)/i.test(file);

// Same-name "gantry-v2.<hash>.min.js" files 403 on the CDN even in old, fully-mined builds. Track them, don't fail on them.
// The gantry translation bundles listed by the signed-in pages (gantry-v2-translations_<locale>.gantry-v2.<hash>.min.js) are 403 on every CDN path too.
export const isPhantom = (file) => /^gantry-v2\.[0-9a-f]+\.min\.js$/.test(file) || /^gantry-v2-translations_[\w-]+\.gantry-v2\.[0-9a-f]+\.min\.js$/.test(file);

const API_RE = new RegExp(`["'\`]((?:${[...KNOWN_NS].join('|')})(?:\\.[a-zA-Z][a-zA-Z0-9_]{0,40}){1,5})["'\`]`, 'g');
// A dotted string passed right after an api-call-looking prefix, from a namespace we do not know yet.
const CAND_RE = /(?:api|apiCall|callApi|method)\W{0,12}["']([a-z][a-zA-Z]{1,24}(?:\.[a-zA-Z][a-zA-Z0-9]{0,40}){1,5})["']/g;

const JUNK = /\.(com|org|net|io|js|json|asar|css|svg|png|html)$|^(google\.protobuf|platform\.(native|web)\.)|^(presence\.ts|entity\.name|quip\.codes)$/i;

// Unquoted mentions ("failed to call search.team", "Poll files.list until...", `calls.request` in an error string): the client
// still uses these methods but not as a bare quoted literal. Only trusted for names we already track (see mine.mjs).
const MENTION_RE = new RegExp(`(?<![\\w.$])(?:${[...KNOWN_NS].join('|')})(?:\\.[A-Za-z][A-Za-z0-9_]{0,40}){1,5}`, 'g');

export function extractMethods(js) {
  const known = new Set();
  const candidates = new Set();
  const mentioned = new Set();
  for (const m of js.matchAll(API_RE)) if (!JUNK.test(m[1])) known.add(m[1]);
  for (const m of js.matchAll(CAND_RE)) if (!KNOWN_NS.has(m[1].split('.')[0])) candidates.add(m[1]);
  for (const m of js.matchAll(MENTION_RE)) if (!JUNK.test(m[0])) mentioned.add(m[0]);
  return { known, candidates, mentioned };
}

// Merge this run's names into state.
//   miss    consecutive mined builds in which the name was not found
//   absent  true once miss >= ABSENT_AFTER, so one odd build (a lazily loaded chunk, an A/B test) does not flip a method
//   ours    true once this miner has seen the name itself (as opposed to names only known from 3kh0/slack-datamine history)
export const ABSENT_AFTER = 3;

export function mergeState(state, names, build, date) {
  const seen = new Set(names);
  for (const n of seen) {
    const e = (state[n] ??= { first_build: build, first_seen: date });
    e.last_build = build;
    e.last_seen = date;
    e.miss = 0;
    e.ours = true;
  }
  const out = {};
  for (const n of Object.keys(state).sort()) {
    const e = { ...state[n] };
    if (!seen.has(n)) e.miss = (e.miss ?? ABSENT_AFTER) + 1;
    e.absent = (e.miss ?? ABSENT_AFTER) >= ABSENT_AFTER;
    delete e.removed;
    out[n] = e;
  }
  return out;
}
