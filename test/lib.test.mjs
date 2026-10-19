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

test('mergeState keeps first_seen, updates last_seen, flags removed', () => {
  let s = mergeState({}, ['a.b', 'c.d'], '1', '2026-01-01');
  s = mergeState(s, ['a.b'], '2', '2026-01-02');
  assert.deepEqual(s['a.b'], { first_build: '1', first_seen: '2026-01-01', last_build: '2', last_seen: '2026-01-02', removed: false });
  assert.equal(s['c.d'].removed, true);
  assert.equal(s['c.d'].last_build, '1');
  s = mergeState(s, ['a.b', 'c.d'], '3', '2026-01-03');
  assert.equal(s['c.d'].removed, false);
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
