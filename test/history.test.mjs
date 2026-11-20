import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { applySnapshot, categoryOf, parseIndex, rebuild, serializeIndex, update, valuesOf } from '../src/history.mjs';

test('categoryOf names lists and skips hashed, prose and info files', () => {
  assert.equal(categoryOf('build/api-methods.txt'), 'api-methods');
  assert.equal(categoryOf('build/platforms/android/feature-flags.txt'), 'android/feature-flags');
  for (const f of ['build/chunks.txt', 'build/ui-strings.txt', 'build/platforms/android/info.txt', 'build/platforms/release-notes/ios.txt', 'build/meta.json', 'build/archive/x.txt', 'src/a.txt']) assert.equal(categoryOf(f), null, f);
});

test('applySnapshot: first seen, removed with last seen, and a comeback keeps first seen', () => {
  const ix = new Map();
  applySnapshot(ix, 'c', valuesOf('a\nb\n'), '2026-01-01');
  applySnapshot(ix, 'c', valuesOf('b\nc\n'), '2026-01-03', '2026-01-02');
  assert.deepEqual(Object.fromEntries(ix.get('c')), {
    a: { first: '2026-01-01', last: '2026-01-02', removed: '2026-01-03' },
    b: { first: '2026-01-01', last: null, removed: null },
    c: { first: '2026-01-03', last: null, removed: null },
  });
  applySnapshot(ix, 'c', valuesOf('a\nb\nc\n'), '2026-01-05');
  assert.deepEqual(ix.get('c').get('a'), { first: '2026-01-01', last: null, removed: null });
  applySnapshot(ix, 'c', null, '2026-01-06', '2026-01-05');
  assert.ok([...ix.get('c').values()].every((e) => e.removed === '2026-01-06'), 'a list that disappeared counts as emptied');
});

test('serializeIndex is sorted, stable and escapes tabs', () => {
  const ix = new Map();
  applySnapshot(ix, 'z', valuesOf('b\na\tx\\y\n'), '2026-01-01');
  applySnapshot(ix, 'a', valuesOf('q\n'), '2026-01-01');
  const t = serializeIndex(ix);
  assert.equal(t, '# category\tvalue\tfirst_seen\tlast_seen\tremoved\na\tq\t2026-01-01\t\t\nz\ta\\tx\\\\y\t2026-01-01\t\t\nz\tb\t2026-01-01\t\t\n');
  assert.equal(serializeIndex(parseIndex(t)), t, 'round-trips');
});

test('rebuild replays git history; an incremental update of the same tree is a no-op, a change is folded in', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdmp-history-'));
  try {
    const g = (date, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: `${date}T12:00:00Z`, GIT_COMMITTER_DATE: `${date}T12:00:00Z` }, stdio: 'ignore' });
    const write = (f, t) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); };
    g('2026-01-01', 'init', '-q');
    write('build/api-methods.txt', 'a.b\nc.d\n'); write('build/chunks.txt', 'x.123\n');
    g('2026-01-01', 'add', '-A'); g('2026-01-01', 'commit', '-qm', '1');
    write('build/api-methods.txt', 'c.d\ne.f\n'); write('build/platforms/android/feature-flags.txt', 'android_x\n');
    g('2026-01-04', 'add', '-A'); g('2026-01-04', 'commit', '-qm', '2');
    write('build/meta.json', '{}');
    g('2026-01-06', 'add', '-A'); g('2026-01-06', 'commit', '-qm', '3');
    const ix = rebuild(dir);
    const text = serializeIndex(ix);
    assert.equal(text, [
      '# category\tvalue\tfirst_seen\tlast_seen\tremoved',
      'android/feature-flags\tandroid_x\t2026-01-04\t\t',
      'api-methods\ta.b\t2026-01-01\t2026-01-01\t2026-01-04',
      'api-methods\tc.d\t2026-01-01\t\t',
      'api-methods\te.f\t2026-01-04\t\t',
    ].join('\n') + '\n');
    assert.equal(serializeIndex(update(parseIndex(text), '2026-01-09', dir, '2026-01-06')), text, 'unchanged tree, unchanged file');
    write('build/api-methods.txt', 'a.b\ne.f\n');
    fs.rmSync(path.join(dir, 'build/platforms'), { recursive: true });
    const next = serializeIndex(update(parseIndex(text), '2026-01-09', dir, '2026-01-06'));
    assert.equal(next, [
      '# category\tvalue\tfirst_seen\tlast_seen\tremoved',
      'android/feature-flags\tandroid_x\t2026-01-04\t2026-01-06\t2026-01-09',
      'api-methods\ta.b\t2026-01-01\t\t',
      'api-methods\tc.d\t2026-01-01\t2026-01-06\t2026-01-09',
      'api-methods\te.f\t2026-01-04\t\t',
    ].join('\n') + '\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
