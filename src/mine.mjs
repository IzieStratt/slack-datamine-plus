#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Mine Slack's web client bundle.
//   node src/mine.mjs                      live: needs SLACK_D_COOKIE (the `d` cookie)
//   node src/mine.mjs --html page.html     saved client HTML (still fetches chunks from the public CDN)
//   node src/mine.mjs --from-dir dir --build 128106   offline: use already-decoded .js files (tests / replays)
// Exits 0 on "nothing new", 2 on an unhealthy manifest (nothing is written), 3 on auth failure.
import fs from 'node:fs';
import path from 'node:path';
import { buildInfo, chunkFiles, decode, extractMethods, isGrammarChunk, isPhantom, manifestChunks, manifestUrl, mergeState } from './lib.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : null; };
const has = (n) => process.argv.includes(`--${n}`);
const MIN_CHUNKS = Number(process.env.MIN_CHUNKS || 300); // below this the manifest parse is broken (it was 14 in 2026-07..10)
const OUT = arg('out') || 'build';
const STATE = arg('state') || 'state/methods.json';
const exclude = new Set(fs.readFileSync(new URL('./exclude.txt', import.meta.url), 'utf8').split('\n').filter(Boolean));
const log = (...a) => console.log(...a);
// Debug files get uploaded as workflow artifacts (downloadable by any GitHub user on a public repo). Never let a token reach them,
// and never upload the authed page itself (it also holds the account's name, email and ids): only counts and script URLs.
export const redact = (t) => {
  let out = t
    .replace(/xox[a-z](?:\.xox[a-z])?-[A-Za-z0-9%._\/+=-]{4,}/gi, 'xox?-REDACTED')
    .replace(/((?:api_token|token|crumb|d|d-s|enterprise_token|email)["']?\s*[:=]\s*["']?)[^"'&\s,}]{4,}/gi, '$1REDACTED');
  for (const secret of [process.env.SLACK_D_COOKIE].filter(Boolean)) {
    for (const v of new Set([secret, encodeURIComponent(secret), safeDecode(secret)])) if (v) out = out.split(v).join('REDACTED');
  }
  return out;
};
const safeDecode = (v) => { try { return decodeURIComponent(v); } catch { return v; } };
const writeDebug = (name, text) => { fs.mkdirSync('debug', { recursive: true }); fs.writeFileSync(`debug/${name}`, redact(text)); };
// What a failed run saves about the fetched page: no body, just enough to see why discovery failed.
const pageSummary = (html, url) => JSON.stringify({
  finalUrl: url, bytes: html.length, title: html.match(/<title>([^<]*)/)?.[1] ?? null,
  scripts: [...html.matchAll(/<script[^>]*\ssrc="([^"?]+)/g)].map((m) => m[1]),
  hasManifest: !!manifestUrl(html), versionUid: /boot_data\.version_uid\s*=\s*"[0-9a-f]{40}"/.test(html),
}, null, 1);
const sh = (k, v) => process.env.GITHUB_OUTPUT && fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);

async function fetchHtml() {
  const cookie = process.env.SLACK_D_COOKIE;
  if (!cookie) { console.error('SLACK_D_COOKIE is not set'); process.exit(3); }
  let url = process.env.SLACK_CLIENT_URL || 'https://app.slack.com/client/E09V59WQY1E';
  const slackHost = (u) => { const x = new URL(u); return x.protocol === 'https:' && (x.hostname === 'slack.com' || x.hostname.endsWith('.slack.com')); };
  if (!slackHost(url)) { console.error('SLACK_CLIENT_URL must be an https://*.slack.com URL'); process.exit(3); }
  for (let hop = 0; hop < 8; hop++) {
    if (!slackHost(url)) { console.error('refusing to follow a redirect off slack.com (the d cookie would be sent there)'); process.exit(3); }
    const headers = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36', cookie: `d=${cookie}` };
    const res = await fetch(url, { headers, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) { url = new URL(res.headers.get('location'), url).href; continue; }
    if (!res.ok) { console.error(`client HTML: HTTP ${res.status} at ${url}`); process.exit(3); }
    const html = await res.text();
    if (/terms-of-service\.[0-9a-f]+\.min\.js/.test(html)) {
      fs.mkdirSync('debug', { recursive: true });
      console.error(`landed on the Terms of Service page at ${url}: log in as this account in a browser and accept the terms, then re-run`);
      process.exit(3);
    }
    if (/sign[_ ]?in|ssb\/redirect/i.test(new URL(url).pathname) || !/version_ts|build-number|boot_data\.version_uid/.test(html)) {
      writeDebug('page-summary.json', pageSummary(html, url));
      console.error(`did not land on an authed client page (ended at ${url}); cookie expired or invalidated? saved debug/page-summary.json`);
      process.exit(3);
    }
    return html;
  }
  console.error('too many redirects'); process.exit(3);
}

async function get(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 403 || r.status === 404) return { status: r.status };
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { status: 200, js: decode(Buffer.from(await r.arrayBuffer())) };
    } catch (e) { last = e; await new Promise((r) => setTimeout(r, 500 * (i + 1))); }
  }
  throw last;
}

// Workers keep running while any task is in flight, because a finished task may append more items to the shared array.
async function pool(items, n, fn) {
  let i = 0, inflight = 0;
  const worker = async () => {
    for (;;) {
      if (i < items.length) { inflight++; try { await fn(items[i++]); } finally { inflight--; } }
      else if (inflight > 0) await new Promise((r) => setTimeout(r, 5));
      else return;
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
}

async function main() {
  const date = new Date().toISOString().slice(0, 10);
  const prev = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  const prevMeta = fs.existsSync(`${OUT}/meta.json`) ? JSON.parse(fs.readFileSync(`${OUT}/meta.json`, 'utf8')) : {};
  let buildNumber, names = new Set(), candidates = new Set(), mentioned = new Set(), stats = {};

  if (arg('from-dir')) {
    buildNumber = arg('build') || 'local';
    for (const f of fs.readdirSync(arg('from-dir')).filter((f) => f.endsWith('.js') && !isGrammarChunk(f))) {
      const r = extractMethods(decode(fs.readFileSync(path.join(arg('from-dir'), f))));
      r.known.forEach((n) => names.add(n)); r.candidates.forEach((n) => candidates.add(n)); r.mentioned.forEach((n) => mentioned.add(n));
    }
    stats = { source: 'from-dir' };
  } else {
    const html = arg('html') ? fs.readFileSync(arg('html'), 'utf8') : await fetchHtml();
    const info = buildInfo(html);
    if (!info.buildNumber || !info.cdn) { writeDebug('page-summary.json', pageSummary(html, 'n/a')); console.error('no valid build id / CDN base in HTML; saved debug/page-summary.json'); process.exit(2); }
    buildNumber = info.buildNumber;
    sh('build', buildNumber);
    if (!has('force') && prevMeta.buildNumber === buildNumber) { log(`build ${buildNumber} already mined`); sh('changed', 'false'); return; }
    log(`build ${buildNumber}: discovering chunks`);

    // crawl: HTML -> chunk files -> any chunk files those mention, until nothing new
    const queue = [...chunkFiles(html)];
    const mUrl = manifestUrl(html);
    if (mUrl) {
      const r = await get(mUrl);
      if (r.status === 200) manifestChunks(r.js).forEach((f) => queue.push(f));
      else console.error(`webpack manifest fetch: HTTP ${r.status}`);
    }
    log(`manifest ${mUrl ?? 'not found'}: ${queue.length} chunk names`);
    const seen = new Set(queue), ok = [], phantom = [], missing = [];
    await pool(queue, 12, async function visit(file) {
      if (isPhantom(file)) { phantom.push(file); return; }
      const r = await get(info.cdn + file);
      if (r.status !== 200) { missing.push({ file, status: r.status }); return; }
      ok.push(file);
      if (isGrammarChunk(file)) return;
      const ex = extractMethods(r.js);
      ex.known.forEach((n) => names.add(n)); ex.candidates.forEach((n) => candidates.add(n)); ex.mentioned.forEach((n) => mentioned.add(n));
      for (const f of chunkFiles(r.js)) if (!seen.has(f)) { seen.add(f); queue.push(f); }
    });
    stats = { discovered: seen.size, fetched: ok.length, phantom: phantom.length, missing: missing.length };
    log(JSON.stringify(stats));
    if (ok.length < MIN_CHUNKS) {
      console.error(`unhealthy manifest: only ${ok.length} real chunks (< ${MIN_CHUNKS}). Not writing anything.`);
      writeDebug('page-summary.json', pageSummary(html, 'n/a'));
      writeDebug('chunks.json', JSON.stringify({ stats, missing, phantom }, null, 1));
      sh('changed', 'false'); process.exit(2);
    }
  }

  // a method we already track that the bundle still mentions (log text, descriptions) is not removed
  for (const n of mentioned) if (prev[n] && !exclude.has(n)) names.add(n);
  const prevLive = Number(prevMeta.apiMethods || 0);
  if (prevLive && names.size < 0.6 * prevLive && !has('force')) {
    console.error(`method count dropped from ${prevLive} to ${names.size} (<60%); looks like an extractor/bundle change, not a real removal. Not writing anything (use --force to override).`);
    sh('changed', 'false'); process.exit(2);
  }
  const state = mergeState(prev, names, buildNumber, date);
  fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(`${OUT}/api-methods.txt`, [...names].sort().join('\n') + '\n');
  fs.writeFileSync(`${OUT}/api-candidates.txt`, [...candidates].sort().join('\n') + '\n');
  fs.writeFileSync(STATE, JSON.stringify(state, null, 1) + '\n');
  const removed = Object.values(state).filter((e) => e.removed).length;
  fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify({ buildNumber, capturedDate: date, ...stats, apiMethods: names.size, tracked: Object.keys(state).length, removed }, null, 1) + '\n');
  log(`build ${buildNumber}: ${names.size} methods, ${Object.keys(state).length} tracked, ${removed} removed`);
  sh('changed', 'true');
}
main().catch((e) => { console.error(e); process.exit(1); });
