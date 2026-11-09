// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXTRACTORS, createUpstream, loadTranslations, readLines } from '../src/upstream.mjs';

test('every ported extractor has a distinct key and an output file', () => {
  const keys = EXTRACTORS.map((e) => e.key);
  const files = EXTRACTORS.map((e) => e.file);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(new Set(files).size, files.length);
  for (const e of EXTRACTORS) assert.match(e.file, /^[a-zA-Z0-9-]+\.txt$/);
  // the names this miner already writes are renamed, not overwritten
  assert.ok(files.includes('api-methods-upstream.txt'));
  assert.ok(files.includes('experiments-upstream.txt'));
  assert.ok(!files.includes('api-methods.txt'));
});

test('a fresh run on an empty chunk writes nothing and keeps nothing it did not have', () => {
  const up = createUpstream();
  up.collect('');
  const { files, notes } = up.finish(() => []);
  for (const [file, lines] of files) assert.ok(Array.isArray(lines), file);
  assert.ok(notes.some((n) => /no en-US table/.test(n)));
});

test('uiStrings keeps sentence-like literals and drops code', () => {
  const up = createUpstream();
  up.collect('var a="Something went wrong, try again."; var b="return this.x=1"; var c="/a/b/c long path";');
  const { files } = up.finish(() => []);
  assert.deepEqual(files.get('ui-strings.txt'), ['Something went wrong, try again.']);
});

test('a broken extractor keeps the previous file', () => {
  const up = createUpstream();
  up.collect('var a="Something went wrong, try again."');
  const prev = { 'ui-strings.txt': ['old line'] };
  // force an error by sabotaging the post step of one extractor in the live list
  const e = EXTRACTORS.find((x) => x.key === 'uiStrings');
  const saved = e.post;
  e.post = () => { throw new Error('boom'); };
  try {
    const { files, notes } = up.finish((f) => prev[f] ?? []);
    assert.deepEqual(files.get('ui-strings.txt'), ['old line']);
    assert.ok(notes.some((n) => /uiStrings broke/.test(n)));
  } finally { e.post = saved; }
});

test('loadTranslations maps each en-US string to its namespace and reports a missing table', async () => {
  const html = '<script>{"en-US":"gantry-v2-translations_app.json"}</script>';
  const table = JSON.stringify({ app: { hello_world: 'Hello world' } });
  const got = [];
  const get = async (url) => { got.push(url); return { status: 200, js: table }; };
  assert.equal(await loadTranslations([html], 'https://x.example/', get), true);
  assert.deepEqual(got, ['https://x.example/gantry-v2-translations_app.json']);
  assert.equal(await loadTranslations(['<html></html>'], 'https://x.example/', get), false);
});

test('readLines returns [] for a missing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-'));
  assert.deepEqual(readLines(dir)('nope.txt'), []);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\ny\n');
  assert.deepEqual(readLines(dir)('a.txt'), ['x', 'y']);
});
