#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Mine Slack's web client bundle.
//   node src/mine.mjs                      live: needs SLACK_D_COOKIE (the `d` cookie)
//   node src/mine.mjs --html page.html     saved client HTML (still fetches chunks from the public CDN)
//   node src/mine.mjs --from-dir dir --build 128106   offline: use already-decoded .js files (tests / replays)
// Exits 0 on "nothing new", 2 on an unhealthy manifest (nothing is written), 3 on auth failure.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { extractParams, mergeParams, serializeParams } from './params.mjs';
import { emptyExtras, extractExtras, finishExperiments, scanExperiments } from './extras.mjs';
import { extractIconSet } from './icons.mjs';
import { checkHealth } from './health.mjs';
import { emptyFrontend, finishFrontend, scanFrontend } from './frontend.mjs';
import { emptyPresence, finishPresence, scanWatched } from './watch.mjs';
import { diffSources, pageAssets, sourceIds } from './sources.mjs';
import { buildInfo, chunkFiles, chunkMapFiles, decode, extractMethods, isGrammarChunk, isPhantom, manifestChunks, manifestUrl, mergeState } from './lib.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : null; };
const has = (n) => process.argv.includes(`--${n}`);
const MIN_CHUNKS = Number(process.env.MIN_CHUNKS || 300); // below this the manifest parse is broken (it was 14 in 2026-07..10)
const OUT = arg('out') || 'build';
const STATE = arg('state') || 'state/methods.json';
const exclude = new Set(fs.readFileSync(new URL('./exclude.txt', import.meta.url), 'utf8').split('\n').filter(Boolean));
const log = (...a) => console.log(...a);
// Slack serves a different page by browser version (not OS): Chrome below ~138, Safari 17, Firefox 125, curl, an empty UA... get the older shell
// (webpack manifest only); a recent Chrome/Edge/Firefox/Safari, or any UA with a Slack_SSB token, gets the gantry client page that lists client-boot
// and gantry-v2-vendors and carries the whole async chunk map inline. We mine both: the legacy shell is the primary page (its manifest crawl and
// build id), the gantry page is added with the modern UA. A health check fires if the modern UA stops getting the gantry page.
const UA_LEGACY = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
const UA_MODERN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
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

// `startUrl` defaults to the org client. With `tolerant` a page that can't be used returns null instead of ending the run (extra pages are a bonus).
async function fetchHtml(startUrl = process.env.SLACK_CLIENT_URL || 'https://app.slack.com/client/E09V59WQY1E', tolerant = false, ua = UA_LEGACY) {
  const die = () => { if (!tolerant) process.exit(3); return null; };
  const cookie = process.env.SLACK_D_COOKIE;
  if (!cookie) { console.error('SLACK_D_COOKIE is not set'); process.exit(3); }
  let url = startUrl;
  const slackHost = (u) => { const x = new URL(u); return x.protocol === 'https:' && (x.hostname === 'slack.com' || x.hostname.endsWith('.slack.com')); };
  if (!slackHost(url)) { console.error('SLACK_CLIENT_URL must be an https://*.slack.com URL'); return die(); }
  for (let hop = 0; hop < 8; hop++) {
    if (!slackHost(url)) { console.error('refusing to follow a redirect off slack.com (the d cookie would be sent there)'); return die(); }
    const headers = { 'user-agent': ua, cookie: `d=${cookie}` };
    const res = await fetch(url, { headers, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) { url = new URL(res.headers.get('location'), url).href; continue; }
    if (!res.ok) { console.error(`client HTML: HTTP ${res.status} at ${url}`); return die(); }
    const html = await res.text();
    if (/terms-of-service\.[0-9a-f]+\.min\.js/.test(html)) {
      fs.mkdirSync('debug', { recursive: true });
      console.error(`landed on the Terms of Service page at ${url}: log in as this account in a browser and accept the terms, then re-run`);
      return die();
    }
    if (/sign[_ ]?in|ssb\/redirect/i.test(new URL(url).pathname) || !/version_ts|build-number|boot_data\.version_uid/.test(html)) {
      writeDebug('page-summary.json', pageSummary(html, url));
      console.error(`did not land on an authed client page (ended at ${url}); cookie expired or invalidated? saved debug/page-summary.json`);
      return die();
    }
    return html;
  }
  console.error('too many redirects'); return die();
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

// The signed-in page for the org client lists only the webpack manifest. The client's entry scripts (modern.vendor, application, rollup-core_*,
// TS.web: the legacy web client, the icon glyph set, most of the method names) are listed by the public workspace client page, so crawl those
// too. Set ENTRY_PAGE_URL to use another page; if it can't be fetched the crawl just runs without them.
async function entryScripts() {
  const pages = [process.env.ENTRY_PAGE_URL || 'https://app.slack.com/client/T0266FRGM', 'https://slack.com/signin'];
  const names = new Set(), asyncNames = new Set(), htmls = [];
  let complete = true;
  // each page with both user agents: the modern one gets the gantry client (client-boot...), the legacy one gets the older shell with its
  // application/modern.vendor/rollup-* scripts, and both are part of what Slack ships
  for (const [ua, pageUrl] of ['modern', 'legacy'].flatMap((k) => pages.map((u) => [k === 'modern' ? UA_MODERN : UA_LEGACY, u]))) {
    try {
      const r = await fetch(pageUrl, { headers: { 'user-agent': ua } });
      if (!r.ok && r.status !== 403) { console.error(`entry scripts: ${pageUrl} answered HTTP ${r.status}`); complete = false; continue; }
      const html = await r.text();
      htmls.push(html);
      // every script the page lists, including variants like x.<hash>.primer.min.js that the plain chunk-name pattern does not match
      for (const f of [...chunkFiles(html), ...pageAssets(html).filter((a) => a.ext.endsWith('js')).map((a) => a.file)]) if (!f.includes('.marketing.')) names.add(f);
      for (const f of chunkMapFiles(html)) asyncNames.add(f); // the gantry client's inline async chunk map (crawled, but not counted as entry scripts)
    } catch (e) { console.error(`entry scripts: could not fetch ${pageUrl}: ${e.message}`); complete = false; }
  }
  return { names: [...names], asyncNames: [...asyncNames], htmls, complete };
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

// state/params.json keeps the last observed parameter set per method, so a method that later drops out of the bundle keeps its params.
function writeParams(params, build, date) {
  const file = 'state/params.json';
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  for (const [method, keys] of params) {
    if (!keys.size) continue;
    all[method] = { build, seen: date, params: serializeParams(keys) };
  }
  const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(file, JSON.stringify(sorted, null, 1) + '\n');
}

async function main() {
  const date = new Date().toISOString().slice(0, 10);
  const prev = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  const prevMeta = fs.existsSync(`${OUT}/meta.json`) ? JSON.parse(fs.readFileSync(`${OUT}/meta.json`, 'utf8')) : {};
  let archive = null, buildNumber, names = new Set(), candidates = new Set(), mentioned = new Set(), params = new Map(), stats = {}, chunkNames = [];
  const extras = emptyExtras(), expParts = [];
  let iconSet = null, entryComplete = true, gantryBoot = null, gantryPage = false;
  const pageHtmls = [];
  const frontend = emptyFrontend();
  // names someone looks up in the client by name (src/taut-usage.mjs --json output, see TAUT_WATCH); we record how each one is defined
  const watchFile = process.env.TAUT_WATCH || arg('watch');
  const watch = watchFile && fs.existsSync(watchFile) ? [...new Map(JSON.parse(fs.readFileSync(watchFile, 'utf8')).uses.map((u) => [`${u.kind}:${u.name}`, { kind: u.kind, name: u.name }])).values()] : [];
  const presence = emptyPresence();
  const collect = (js) => { extractExtras(js, extras); expParts.push(scanExperiments(js)); iconSet ||= extractIconSet(js); scanFrontend(js, frontend); if (watch.length) scanWatched(js, watch, presence); };

  if (arg('from-dir')) {
    buildNumber = arg('build') || 'local';
    for (const f of fs.readdirSync(arg('from-dir')).filter((f) => f.endsWith('.js') && !isGrammarChunk(f))) {
      const js = decode(fs.readFileSync(path.join(arg('from-dir'), f)));
      const r = extractMethods(js);
      mergeParams(params, extractParams(js)); collect(js); chunkNames.push(f);
      r.known.forEach((n) => names.add(n)); r.candidates.forEach((n) => candidates.add(n)); r.mentioned.forEach((n) => mentioned.add(n));
    }
    stats = { source: 'from-dir' };
  } else {
    const html = arg('html') ? fs.readFileSync(arg('html'), 'utf8') : await fetchHtml();
    const info = buildInfo(html);
    if (!info.buildNumber || !info.cdn) { writeDebug('page-summary.json', pageSummary(html, 'n/a')); console.error('no valid build id / CDN base in HTML; saved debug/page-summary.json'); process.exit(2); }
    buildNumber = info.buildNumber;
    sh('build', buildNumber);
    // The gantry client pages (modern UA): the signed-in org and workspace pages (SLACK_EXTRA_CLIENT_URLS is a comma separated list of more), plus
    // the public ones below. They list client-boot and gantry-v2-vendors and carry the async chunk map. A page that fails is skipped.
    const extraHtmls = [], extraNames = new Set(), extraAsync = new Set();
    for (const u of [...new Set([process.env.SLACK_CLIENT_URL || 'https://app.slack.com/client/E09V59WQY1E', ...(process.env.SLACK_EXTRA_CLIENT_URLS ?? 'https://app.slack.com/client/T0266FRGM').split(',').map((x) => x.trim()).filter(Boolean)])]) {
      const h = await fetchHtml(u, true, UA_MODERN);
      if (!h) { console.error(`extra client page not usable: ${u}`); continue; }
      extraHtmls.push(h);
      // names only (no page content): anything in the page that looks like a boot/gantry/vendors bundle, to see how the client loads them
      const hints = [...new Set([...h.replace(/\\\//g, '/').matchAll(/[A-Za-z0-9_.\/-]{0,60}(?:boot|gantry|vendors)[A-Za-z0-9_.\/-]{0,60}/g)].map((m) => m[0]))].slice(0, 40);
      log(`signed-in page ${u}: boot-like names: ${hints.join(' ') || 'none'}`);
      const names = [...chunkFiles(h), ...pageAssets(h).filter((a) => a.ext.endsWith('js')).map((a) => a.file)].filter((f) => !f.includes('.marketing.'));
      names.forEach((f) => extraNames.add(f));
      for (const f of chunkMapFiles(h)) extraAsync.add(f);
      log(`signed-in page ${u}: ${names.length} scripts: ${names.map((f) => f.split('.')[0]).slice(0, 40).join(' ')}`);
    }
    const { names: entry0, asyncNames, htmls: entryHtmls, complete } = await entryScripts();
    const entry = [...new Set([...entry0, ...extraNames])];
    entryComplete = complete;
    // which gantry client build this is: the client-boot file name carries its content hash
    gantryBoot = entry.find((f) => /^client-boot\.[0-9a-f]{16}\.min\.js$/.test(f)) ?? null;
    gantryPage = !!gantryBoot && (asyncNames.length + extraAsync.size) > 0;
    if (!has('force') && prevMeta.buildNumber === buildNumber && (prevMeta.gantryBoot ?? null) === gantryBoot) { log(`build ${buildNumber} already mined`); sh('changed', 'false'); return; }
    log(`build ${buildNumber}: discovering chunks`);
    { const urls = new Set([...html.replace(/\\\//g, '/').matchAll(/https:\/\/[a-z0-9.-]*slack-edge\.com\/[^"'\s\\<>)]+/g)].map((m) => m[0].split('?')[0])); log(`page cdn urls (${urls.size}): ${[...urls].slice(0, 80).join(' ')}`); } // public CDN urls only
    log(`page scripts: ${[...html.matchAll(/<script[^>]*\ssrc="([^"?]+)/g)].map((m) => m[1].split('/').pop()).join(' ')}`); // public file names only; shows which entry scripts the crawl starts from

    // crawl: HTML -> chunk files -> any chunk files those mention, until nothing new
    const queue = [...chunkFiles(html)];
    const mUrl = manifestUrl(html);
    if (mUrl) {
      const r = await get(mUrl);
      if (r.status === 200) { manifestChunks(r.js).forEach((f) => queue.push(f)); archive = { manifest: r.js }; }
      else console.error(`webpack manifest fetch: HTTP ${r.status}`);
    }
    log(`manifest ${mUrl ?? 'not found'}: ${queue.length} chunk names`);
    log(`entry scripts from the public client pages: ${entry.length}`);
    for (const f of entry) if (!queue.includes(f)) queue.push(f);
    const inQueue = new Set(queue);
    for (const f of [...chunkMapFiles(html), ...asyncNames, ...extraAsync]) if (!inQueue.has(f)) { inQueue.add(f); queue.push(f); }
    log(`gantry async chunks from the pages' inline map: ${inQueue.size - queue.length + [...chunkMapFiles(html), ...asyncNames, ...extraAsync].length}`);
    pageHtmls.push(html, ...extraHtmls, ...entryHtmls);
    const seen = new Set(queue), ok = [], phantom = [], missing = [];
    await pool(queue, 12, async function visit(file) {
      if (isPhantom(file)) { phantom.push(file); return; }
      const r = await get(info.cdn + file);
      if (r.status !== 200) { missing.push({ file, status: r.status }); return; }
      ok.push(file); chunkNames.push(file);
      if (isGrammarChunk(file)) return;
      const ex = extractMethods(r.js);
      mergeParams(params, extractParams(r.js)); collect(r.js);
      ex.known.forEach((n) => names.add(n)); ex.candidates.forEach((n) => candidates.add(n)); ex.mentioned.forEach((n) => mentioned.add(n));
      for (const f of chunkFiles(r.js)) if (!seen.has(f)) { seen.add(f); queue.push(f); }
    });
    stats = { entryScripts: entry.filter((f) => !isPhantom(f)).length, entryFetched: entry.filter((f) => ok.includes(f)).length, cdn: info.cdn, manifestUrl: mUrl, versionHash: info.versionHash, versionTs: info.versionTs, discovered: seen.size, fetched: ok.length, phantom: phantom.length, missing: missing.length };
    { const lost = entry.filter((f) => !isPhantom(f) && !ok.includes(f)); if (lost.length) console.error(`entry scripts that could not be fetched: ${lost.join(' ')}`); }
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
  const absent = Object.values(state).filter((e) => e.absent).length;
  writeParams(params, buildNumber, date);
  const exp = finishExperiments(expParts);
  const counts = {};
  for (const [cat, set] of Object.entries(extras)) {
    counts[cat] = set.size;
    if (set.size) fs.writeFileSync(`${OUT}/${cat}.txt`, [...set].sort().join('\n') + '\n');
  }
  // the glyph set behind the icon names (build/icons.json drives the icons PDF; it comes from modern.vendor); keep the old one if this build's chunk was missing
  if (iconSet) fs.writeFileSync(`${OUT}/icons.json`, JSON.stringify(iconSet) + '\n');
  else console.error('icons: glyph set not found, keeping previous build/icons.json');
  // keep the manifest bytes and the entry-script list so this build can be re-mined later (Slack retires whole CDN buckets)
  if (archive) {
    fs.mkdirSync(`${OUT}/archive`, { recursive: true });
    fs.writeFileSync(`${OUT}/archive/${buildNumber}.manifest.js.gz`, zlib.gzipSync(archive.manifest, { level: 9 }));
  }
  fs.writeFileSync(`${OUT}/chunks.txt`, chunkNames.sort().join('\n') + '\n');
  // no selector module found = the extractor broke or the chunk was missing: keep the previous experiments files rather than emptying them
  if (exp.selectorModules) {
    fs.writeFileSync(`${OUT}/experiments.json`, JSON.stringify(exp.experiments, null, 1) + '\n');
    fs.writeFileSync(`${OUT}/experiments.txt`, Object.keys(exp.experiments).join('\n') + '\n');
  } else console.error('experiments: selector module not found, keeping previous experiments files');
  // components and redux (thunks, actions, fetchers, ...): lists for the changes feed, json with module ids/hashes and descriptions
  const fe = finishFrontend(frontend);
  if (fe.componentNames.length && fe.reduxNames.length) {
    fs.writeFileSync(`${OUT}/components.txt`, fe.componentNames.join('\n') + '\n');
    fs.writeFileSync(`${OUT}/components.json`, JSON.stringify(fe.components) + '\n');
    fs.writeFileSync(`${OUT}/redux.txt`, fe.reduxNames.join('\n') + '\n');
    fs.writeFileSync(`${OUT}/redux.json`, JSON.stringify(fe.redux) + '\n');
  } else console.error('components/redux: none found, keeping the previous files');
  if (watch.length) fs.writeFileSync(`${OUT}/taut-presence.json`, JSON.stringify(finishPresence(presence, watch), null, 1) + '\n');
  counts.components = fe.componentNames.length;
  counts.redux = fe.reduxNames.length;
  counts.experiments = Object.keys(exp.experiments).length;
  counts.experimentsWithGroups = Object.values(exp.experiments).filter((g) => g.length).length;
  const metaOut = { buildNumber, capturedDate: date, ...stats, gantryBoot, gantryPage, iconGlyphs: iconSet ? Object.keys(iconSet.icons).length : 0, experimentsSelector: exp.selectorModules, apiMethods: names.size, tracked: Object.keys(state).length, absent, methodsWithObservedParams: [...params].filter(([, k]) => k.size).length, chunks: chunkNames.length, mined: counts };
  fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify(metaOut, null, 1) + '\n');
  // gaps (a source missing, a category collapsing) are written down so the workflow can raise them instead of letting them pass silently
  if (stats.source !== 'from-dir') {
    const problems = checkHealth(prevMeta, metaOut);
    // source inventory: a bundle, page asset or chunk family we have not seen before (or that vanished) is reported, not silently skipped.
    // The first run only writes the baseline. If a page failed to fetch, nothing is reported as gone (it would just come back next run).
    const sourcesFile = `${OUT}/sources.txt`;
    const prevSources = fs.existsSync(sourcesFile) ? fs.readFileSync(sourcesFile, 'utf8').split('\n').filter(Boolean) : null;
    let ids = sourceIds({ pages: pageHtmls, chunks: chunkNames });
    if (prevSources && !entryComplete) ids = [...new Set([...ids, ...prevSources])].sort();
    const notices = [];
    if (prevSources) { const d = diffSources(prevSources, ids); notices.push(...d.added.map((x) => `new source: ${x}`), ...d.removed.map((x) => `source gone: ${x}`)); }
    fs.writeFileSync(sourcesFile, ids.join('\n') + '\n');
    fs.writeFileSync(`${OUT}/health.json`, JSON.stringify({ ok: !problems.length, problems, notices }, null, 1) + '\n');
    sh('health', problems.length ? 'bad' : 'ok');
    sh('notices', notices.length ? 'yes' : 'no');
    for (const x of problems) console.error(`health: ${x}`);
    for (const x of notices) log(`sources: ${x}`);
  }
  log(`build ${buildNumber}: ${names.size} methods, ${Object.keys(state).length} tracked, ${absent} absent`);
  sh('changed', 'true');
}
main().catch((e) => { console.error(e); process.exit(1); });
