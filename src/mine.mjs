#!/usr/bin/env node
// Mine Slack's web client bundle.
//   node src/mine.mjs                      live: needs SLACK_D_COOKIE (the `d` cookie)
//   node src/mine.mjs --html page.html     saved client HTML (still fetches chunks from the public CDN)
//   node src/mine.mjs --from-dir dir --build 128106   offline: use already-decoded .js files (tests / replays)
// Exits 0 on "nothing new", 2 on an unhealthy manifest (nothing is written), 3 on auth failure.
import fs from 'node:fs';
import path from 'node:path';
import { buildInfo, chunkFiles, decode, extractMethods, isPhantom, mergeState } from './lib.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : null; };
const has = (n) => process.argv.includes(`--${n}`);
const MIN_CHUNKS = Number(process.env.MIN_CHUNKS || 300); // below this the manifest parse is broken (it was 14 in 2026-07..10)
const OUT = arg('out') || 'build';
const STATE = arg('state') || 'state/methods.json';
const log = (...a) => console.log(...a);
const sh = (k, v) => process.env.GITHUB_OUTPUT && fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);

async function fetchHtml() {
  const cookie = process.env.SLACK_D_COOKIE;
  if (!cookie) { console.error('SLACK_D_COOKIE is not set'); process.exit(3); }
  let url = process.env.SLACK_CLIENT_URL || 'https://app.slack.com/client';
  for (let hop = 0; hop < 8; hop++) {
    const host = new URL(url).hostname;
    const headers = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36' };
    if (host.endsWith('slack.com')) headers.cookie = `d=${cookie}`; // never leaves slack.com
    const res = await fetch(url, { headers, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) { url = new URL(res.headers.get('location'), url).href; continue; }
    if (!res.ok) { console.error(`client HTML: HTTP ${res.status} at ${url}`); process.exit(3); }
    const html = await res.text();
    if (/sign[_ ]?in|ssb\/redirect/i.test(new URL(url).pathname) || !/version_ts|build-number/.test(html)) {
      fs.mkdirSync('debug', { recursive: true }); fs.writeFileSync('debug/client.html', html);
      console.error(`did not land on an authed client page (ended at ${url}); cookie expired or invalidated? saved debug/client.html`);
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

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

async function main() {
  const date = new Date().toISOString().slice(0, 10);
  const prev = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  const prevMeta = fs.existsSync(`${OUT}/meta.json`) ? JSON.parse(fs.readFileSync(`${OUT}/meta.json`, 'utf8')) : {};
  let buildNumber, names = new Set(), candidates = new Set(), stats = {};

  if (arg('from-dir')) {
    buildNumber = arg('build') || 'local';
    for (const f of fs.readdirSync(arg('from-dir')).filter((f) => f.endsWith('.js'))) {
      const r = extractMethods(fs.readFileSync(path.join(arg('from-dir'), f), 'utf8'));
      r.known.forEach((n) => names.add(n)); r.candidates.forEach((n) => candidates.add(n));
    }
    stats = { source: 'from-dir' };
  } else {
    const html = arg('html') ? fs.readFileSync(arg('html'), 'utf8') : await fetchHtml();
    const info = buildInfo(html);
    if (!info.buildNumber || !info.cdn) { fs.mkdirSync('debug', { recursive: true }); fs.writeFileSync('debug/client.html', html); console.error('no build number / CDN base in HTML; saved debug/client.html'); process.exit(2); }
    buildNumber = info.buildNumber;
    sh('build', buildNumber);
    if (!has('force') && prevMeta.buildNumber === buildNumber) { log(`build ${buildNumber} already mined`); sh('changed', 'false'); return; }
    log(`build ${buildNumber}: discovering chunks`);

    // crawl: HTML -> chunk files -> any chunk files those mention, until nothing new
    const queue = [...chunkFiles(html)], seen = new Set(queue), ok = [], phantom = [], missing = [];
    await pool(queue, 12, async function visit(file) {
      if (isPhantom(file)) { phantom.push(file); return; }
      const r = await get(info.cdn + file);
      if (r.status !== 200) { missing.push({ file, status: r.status }); return; }
      ok.push(file);
      const ex = extractMethods(r.js);
      ex.known.forEach((n) => names.add(n)); ex.candidates.forEach((n) => candidates.add(n));
      for (const f of chunkFiles(r.js)) if (!seen.has(f)) { seen.add(f); queue.push(f); }
    });
    stats = { discovered: seen.size, fetched: ok.length, phantom: phantom.length, missing: missing.length };
    log(JSON.stringify(stats));
    if (ok.length < MIN_CHUNKS) {
      console.error(`unhealthy manifest: only ${ok.length} real chunks (< ${MIN_CHUNKS}). Not writing anything.`);
      fs.mkdirSync('debug', { recursive: true }); fs.writeFileSync('debug/client.html', html);
      fs.writeFileSync('debug/chunks.json', JSON.stringify({ stats, missing, phantom }, null, 1));
      sh('changed', 'false'); process.exit(2);
    }
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
