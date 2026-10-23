// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { buildInfo, validBuild, decode, chunkFiles, extractMethods, isPhantom, manifestChunks, manifestUrl, mergeState } from '../src/lib.mjs';

test('decode handles brotli, gzip and raw', () => {
  const s = 'var a="chat.postMessage";';
  assert.equal(decode(zlib.brotliCompressSync(s)), s);
  assert.equal(decode(zlib.gzipSync(s)), s);
  assert.equal(decode(Buffer.from(s)), s);
});

test('chunkFiles finds async loader entries and plain filenames', () => {
  const t = 'if("foo-bar"===e)return"gantry-v2-async-"+e+".0123456789abcdef.min.js";x="client-boot.3f71dc1068701009.min.js"';
  assert.deepEqual([...chunkFiles(t)].sort(), ['client-boot.3f71dc1068701009.min.js', 'gantry-v2-async-foo-bar.0123456789abcdef.min.js']);
});

test('phantom gantry-v2 hashes are recognised', () => {
  assert.ok(isPhantom('gantry-v2.164c059b85f07a04989e.min.js'));
  assert.ok(!isPhantom('gantry-v2-vendors.1fbc60a3919eeb23.min.js'));
});

test('extractMethods keeps api names, drops hostnames', () => {
  const { known } = extractMethods('a("chat.postMessage");b("google.com");c(`conversations.history`)');
  assert.deepEqual([...known].sort(), ['chat.postMessage', 'conversations.history']);
});

test('mergeState: first_seen kept, absent only after several misses, ours set when seen', () => {
  let s = mergeState({}, ['a.b', 'c.d'], '1', '2026-01-01');
  assert.deepEqual(s['a.b'], { first_build: '1', first_seen: '2026-01-01', last_build: '1', last_seen: '2026-01-01', miss: 0, ours: true, absent: false });
  s = mergeState(s, ['a.b'], '2', '2026-01-02');
  assert.equal(s['c.d'].absent, false); // one miss is not enough
  s = mergeState(s, ['a.b'], '3', '2026-01-03');
  assert.equal(s['c.d'].absent, false);
  s = mergeState(s, ['a.b'], '4', '2026-01-04');
  assert.equal(s['c.d'].absent, true); // third consecutive miss
  assert.equal(s['c.d'].last_build, '1');
  s = mergeState(s, ['a.b', 'c.d'], '5', '2026-01-05');
  assert.equal(s['c.d'].absent, false); // back in the client
  assert.equal(s['c.d'].miss, 0);
});

test('mergeState: legacy entries without miss that are not seen are absent, and `removed` is dropped', () => {
  const s = mergeState({ 'x.y': { first_build: '9', first_seen: 'd', last_build: '9', last_seen: 'd', removed: true } }, [], '10', 'e');
  assert.equal(s['x.y'].absent, true);
  assert.ok(!('removed' in s['x.y']));
});

test('manifestChunks reads quoted and bare keys from the .u map', () => {
  const js = 'x.u=e=>""+e+"."+({"about-usergroup-view":"cf4965aa5b8b10e8",node_modules_a_mjs:"8da0512b2a57a717"})[e]+".min.js",y';
  assert.deepEqual([...manifestChunks(js)].sort(), ['about-usergroup-view.cf4965aa5b8b10e8.min.js', 'node_modules_a_mjs.8da0512b2a57a717.min.js']);
  assert.equal(manifestChunks('nothing here').size, 0);
});

test('manifestUrl finds the manifest script', () => {
  assert.equal(manifestUrl('<script src="https://a.slack-edge.com/bv1-13-br/webpack.manifest.e8371bcf3e3385dc.min.js">'), 'https://a.slack-edge.com/bv1-13-br/webpack.manifest.e8371bcf3e3385dc.min.js');
});

test('buildInfo only ever yields a plain numeric or 12-hex build id', () => {
  assert.equal(buildInfo('<meta name="build-number" content="x"> build-number="134791" a.slack-edge.com/bv1-13-br/').buildNumber, '134791');
  assert.equal(buildInfo('GA.boot_data.version_uid = "54e9692853f07193c7acfeaa7f7822aa3188c6fb";').buildNumber, '54e9692853f0');
  assert.equal(buildInfo('build-number="1; rm -rf /"').buildNumber, null);
  assert.equal(buildInfo('build-number="12\nchanged=true"').buildNumber, null);
  assert.ok(validBuild('134791') && validBuild('54e9692853f0') && !validBuild('abc') && !validBuild('1 2'));
});

import { checkHealth } from '../src/health.mjs';
test('health: flags missing sources and collapsing categories, passes a healthy run', () => {
  const ok = { entryScripts: 17, entryFetched: 17, iconGlyphs: 720, experimentsSelector: 1, apiMethods: 1553, chunks: 1800, mined: { 'ui-strings': 32000, scopes: 3 } };
  assert.deepEqual(checkHealth(ok, ok), []);
  assert.deepEqual(checkHealth(undefined, ok), []);
  const bad = { ...ok, entryScripts: 0, entryFetched: 0, iconGlyphs: 0, experimentsSelector: 0, apiMethods: 600, mined: { 'ui-strings': 14000, scopes: 0 } };
  const p = checkHealth(ok, bad).join('\n');
  for (const needle of ['no entry scripts', 'icon glyph set', 'experiments selector', 'API methods dropped', 'ui-strings dropped']) assert.ok(p.includes(needle), needle);
  assert.ok(!p.includes('scopes'), 'tiny lists are not flagged');
  assert.ok(checkHealth(ok, { ...ok, entryFetched: 10 }).join().includes('Only 10 of 17'));
});

import { pageAssets, chunkFamilies, sourceIds, diffSources } from '../src/sources.mjs';
test('sources: page assets keep dotted names and drop hashes; families need a few chunks', () => {
  const html = '<script src="https://a.slack-edge.com/bv1-13-br/modern.vendor.cf96ae1c2d386af8.min.js"></script><link href="/application.9ecf7b2c65dc284f.min.css"><script src="TS.web.21a28268dbc76ea4.min.js">';
  assert.deepEqual(pageAssets(html).map((a) => `${a.name}|${a.ext}`), ['modern.vendor|min.js', 'application|min.css', 'TS.web|min.js']);
  const chunks = ['client-a.1.min.js', 'client-b.1.min.js', 'client-c.1.min.js', 'client-d.1.min.js', 'client-e.1.min.js', 'lottie-x.1.min.js'];
  assert.deepEqual(chunkFamilies(chunks), ['client']);
  const ids = sourceIds({ pages: [html], chunks });
  assert.deepEqual(ids, ['asset:TS.web.min.js', 'asset:application.min.css', 'asset:modern.vendor.min.js', 'family:client']);
  assert.deepEqual(diffSources(ids.slice(0, 3), ids), { added: ['family:client'], removed: [] });
  assert.deepEqual(diffSources(ids, ids.slice(1)), { added: [], removed: ['asset:TS.web.min.js'] });
});
