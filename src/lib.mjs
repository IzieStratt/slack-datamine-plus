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

export function buildInfo(html) {
  const attr = (n) => html.match(new RegExp(`${n}["']?\\s*[:=]\\s*["']([^"']+)["']`))?.[1] ?? null;
  const cdn = html.match(/https:\/\/a\.slack-edge\.com\/bv[0-9-]+br\//)?.[0] ?? null;
  return {
    buildNumber: attr('build-number') || attr('build_number') || html.match(/"version_ts":(\d+)/)?.[1] || null,
    versionTs: html.match(/"version_ts":\s*"?(\d+)/)?.[1] ?? null,
    versionHash: html.match(/"version_uid":\s*"([0-9a-f]+)"/)?.[1] ?? null,
    cdn,
  };
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

// Same-name "gantry-v2.<hash>.min.js" files 403 on the CDN even in old, fully-mined builds. Track them, don't fail on them.
export const isPhantom = (file) => /^gantry-v2\.[0-9a-f]+\.min\.js$/.test(file);

const API_RE = new RegExp(`["'\`]((?:${[...KNOWN_NS].join('|')})(?:\\.[a-zA-Z][a-zA-Z0-9_]{0,40}){1,5})["'\`]`, 'g');
// A dotted string passed right after an api-call-looking prefix, from a namespace we do not know yet.
const CAND_RE = /(?:api|apiCall|callApi|method)\W{0,12}["']([a-z][a-zA-Z]{1,24}(?:\.[a-zA-Z][a-zA-Z0-9]{0,40}){1,5})["']/g;

const JUNK = /\.(com|org|net|io|js|json|asar|css|svg|png|html)$/i;

export function extractMethods(js) {
  const known = new Set();
  const candidates = new Set();
  for (const m of js.matchAll(API_RE)) if (!JUNK.test(m[1])) known.add(m[1]);
  for (const m of js.matchAll(CAND_RE)) if (!KNOWN_NS.has(m[1].split('.')[0])) candidates.add(m[1]);
  return { known, candidates };
}

// Merge this run's names into state. A name is `removed` when not in the latest healthy build.
export function mergeState(state, names, build, date) {
  const seen = new Set(names);
  for (const n of seen) {
    const e = (state[n] ??= { first_build: build, first_seen: date });
    e.last_build = build;
    e.last_seen = date;
  }
  const out = {};
  for (const n of Object.keys(state).sort()) out[n] = { ...state[n], removed: !seen.has(n) };
  return out;
}
